const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR);
}
// const ollama = require('ollama')({
//     host: process.env.OLLAMA_HOST || 'http://localhost:11434',
// });

let modelName = 'qwen:0.5b'; // Default Ollama model name for Qwen 0.5B


const preDefinedAiResponses = [
    "I'm here. How can I help?",
    "Yes, I'm listening.",
    "What's on your mind?",
    "Ready when you are!",
    "How may I assist you today?"
];

const aiQueryCounts = new Map(); // Maps userId to query count
const crypto = require('crypto');
const { JSDOM } = require('jsdom');
const DOMPurify = require('dompurify');

const window = new JSDOM('').window;
const purify = DOMPurify(window);

const server = http.createServer((req, res) => {
    let filePath = '.' + req.url;
    if (filePath === './') {
        filePath = './index.html';
    }

    const extname = path.extname(filePath);
    let contentType = 'text/html';
    switch (extname) {
        case '.js':
            contentType = 'text/javascript';
            break;
        case '.css':
            contentType = 'text/css';
            break;
    }

    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code == 'ENOENT') {
                // If the file is not found, check if it's an upload
                if (filePath.startsWith('./uploads/')) {
                    res.writeHead(404);
                    res.end('Uploaded file not found');
                } else {
                    res.writeHead(404);
                    res.end('File not found');
                }
            } else {
                res.writeHead(500);
                res.end('Server error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

const wss = new WebSocket.Server({ server });

const clients = new Map(); // Maps userId to WebSocket
const userVanities = new Map(); // Maps userId to userVanity
const usersTyping = new Map(); // Maps userId to a Set of recipients they are typing to

const fileTransferBuffers = new Map(); // Stores file chunks during transfer

function generateUserId(ip) {
    const hash = crypto.createHash('sha256');
    hash.update(ip + Date.now());
    return `user-${hash.digest('hex').substring(0, 8)}`;
}

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    let currentUserId; // Use a local variable for the current connection's userId

    // Assign a userId immediately upon connection
    // This userId will be used until a reconnect or setVanity message updates it
    // currentUserId will be determined by the first message from the client (reconnect or setVanity)

    ws.on('message', (message) => {
        const parsedMessage = JSON.parse(message);

        if (parsedMessage.type === 'reconnect' && parsedMessage.id && parsedMessage.vanity) {
            const existingWs = [...clients.entries()].find(([clientWs, id]) => id === parsedMessage.id)?.[0];
            if (existingWs && existingWs !== ws) {
                console.log(`Closing old connection for user ${parsedMessage.id} to allow new one to take over.`);
                existingWs.close(1000, 'New connection established');
            }
            currentUserId = parsedMessage.id;
            clients.set(ws, currentUserId); // Update client map with reconnected ID
            userVanities.set(currentUserId, parsedMessage.vanity);
            ws.send(JSON.stringify({ type: 'userId', id: currentUserId, vanity: parsedMessage.vanity })); // Confirm ID to client
            console.log(`Client reconnected with ID: ${currentUserId} (Vanity: ${parsedMessage.vanity})`);
            broadcastUserList(); // Broadcast updated user list after reconnect
        } else if (parsedMessage.type === 'setVanity' && parsedMessage.vanity) {
            if (!currentUserId) { // If this is a new connection setting vanity for the first time
                currentUserId = generateUserId(ip);
                clients.set(ws, currentUserId);
                ws.send(JSON.stringify({ type: 'userId', id: currentUserId })); // Send newly generated ID to client
            }
            userVanities.set(currentUserId, parsedMessage.vanity);
            console.log(`Client ${currentUserId} set vanity to: ${parsedMessage.vanity}`);
            broadcastUserList(); // Broadcast updated user list after vanity is set
        }

        // Now that currentUserId and userVanities are (hopefully) set, process the message
        // Ensure currentUserId is set before proceeding
        if (!currentUserId) {
            currentUserId = generateUserId(ip);
            clients.set(ws, currentUserId);
            userVanities.set(currentUserId, `user-${currentUserId.substring(5, 13)}`); // Assign a default vanity
            ws.send(JSON.stringify({ type: 'userId', id: currentUserId, vanity: userVanities.get(currentUserId) }));
            console.log(`Assigned new ID and default vanity to client: ${currentUserId}`);
            broadcastUserList();
        }

        parsedMessage.sender = currentUserId;
        parsedMessage.senderVanity = userVanities.get(currentUserId);

        if (parsedMessage.type === 'typing') {
            if (!usersTyping.has(currentUserId)) {
                usersTyping.set(currentUserId, new Set());
            }
            if (parsedMessage.recipient) {
                usersTyping.get(currentUserId).add(parsedMessage.recipient);
                const recipientSocket = [...clients.entries()].find(([_, id]) => id === parsedMessage.recipient)?.[0];
                if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
                    recipientSocket.send(JSON.stringify(parsedMessage));
                }
            } else {
                usersTyping.get(currentUserId).add('public');
                broadcast(parsedMessage, ws);
            }
        } else if (parsedMessage.type === 'stoppedTyping') {
            if (usersTyping.has(currentUserId)) {
                if (parsedMessage.recipient) {
                    usersTyping.get(currentUserId).delete(parsedMessage.recipient);
                    const recipientSocket = [...clients.entries()].find(([_, id]) => id === parsedMessage.recipient)?.[0];
                    if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
                        recipientSocket.send(JSON.stringify(parsedMessage));
                    }
                } else {
                    usersTyping.get(currentUserId).delete('public');
                    broadcast(parsedMessage, ws);
                }
                if (usersTyping.get(currentUserId).size === 0) {
                    usersTyping.delete(currentUserId);
                }
            }
        } else if (parsedMessage.type === 'dm') {
            const sanitizedContent = purify.sanitize(parsedMessage.content);
            parsedMessage.content = sanitizedContent;
            const recipientSocket = [...clients.entries()].find(([_, id]) => id === parsedMessage.recipient)?.[0];
            if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
                recipientSocket.send(JSON.stringify(parsedMessage));
            }
        } else if (parsedMessage.type === 'chat') {
            const sanitizedContent = purify.sanitize(parsedMessage.content);
            parsedMessage.content = sanitizedContent;
            broadcast(parsedMessage, ws);
        } else if (parsedMessage.type === 'file_start') {
            const { fileId, fileName, fileSize, fileType, sender, senderVanity, recipient } = parsedMessage;
            fileTransferBuffers.set(fileId, { fileName, fileSize, fileType, sender, senderVanity, recipient, chunks: [], receivedSize: 0 });
            console.log(`File transfer started: ${fileName} (${fileSize} bytes) from ${senderVanity}`);
        } else if (parsedMessage.type === 'file_chunk') {
            const { fileId, chunk, offset } = parsedMessage;
            const transfer = fileTransferBuffers.get(fileId);
            if (transfer) {
                transfer.chunks.push({ chunk, offset });
                transfer.receivedSize += chunk.length;
                // Optional: send progress updates to sender
            }
        } else if (parsedMessage.type === 'file_end') {
            const { fileId } = parsedMessage;
            const transfer = fileTransferBuffers.get(fileId);
            if (transfer) {
                // Sort chunks by offset and reassemble
                transfer.chunks.sort((a, b) => a.offset - b.offset);
                const fileBuffer = Buffer.concat(transfer.chunks.map(c => Buffer.from(c.chunk)));

                if (fileBuffer.length !== transfer.fileSize) {
                    console.error(`File reassembly error: ${transfer.fileName}. Expected ${transfer.fileSize}, got ${fileBuffer.length}`);
                    // Handle error: notify sender, clean up
                    fileTransferBuffers.delete(fileId);
                    return;
                }

                const uniqueFileName = `${Date.now()}-${transfer.fileName}`;
                const filePath = path.join(UPLOADS_DIR, uniqueFileName);

                fs.writeFile(filePath, fileBuffer, (err) => {
                    if (err) {
                        console.error(`Error saving file ${transfer.fileName}:`, err);
                        // Handle error
                    } else {
                        console.log(`File saved: ${filePath}`);
                        const fileUrl = `/uploads/${uniqueFileName}`;
                        // Broadcast file_complete message
                        broadcast({
                            type: 'file_complete',
                            fileId: fileId,
                            fileName: transfer.fileName,
                            fileSize: transfer.fileSize,
                            fileType: transfer.fileType,
                            fileUrl: fileUrl,
                            sender: transfer.sender,
                            senderVanity: transfer.senderVanity,
                            recipient: transfer.recipient,
                        });
                    }
                    fileTransferBuffers.delete(fileId); // Clean up buffer
                });
            }
        } else if (parsedMessage.type === 'file') {
            // This case is for the old file sending method, which will be removed later
            // For now, we just broadcast it as is.
            broadcast(parsedMessage, ws);
        } /* else if (parsedMessage.type === 'aiQuery') {
            const userId = parsedMessage.sender;
            const currentCount = aiQueryCounts.get(userId) || 0;

            if (!ollama) {
                ws.send(JSON.stringify({
                    type: 'chat',
                    sender: 'Qwen AI',
                    senderVanity: 'Qwen AI',
                    content: `Qwen AI (Ollama) is not initialized. To enable AI features, please install Ollama from https://ollama.com/ and pull the Qwen model (e.g., 'ollama pull qwen:0.5b'). Ensure Ollama is running and accessible. You can specify the Ollama host using the OLLAMA_HOST environment variable.`
                }));
                return;
            }

            const userQuery = parsedMessage.content;
            if (userQuery.trim() === '') {
                const randomResponse = preDefinedAiResponses[Math.floor(Math.random() * preDefinedAiResponses.length)];
                broadcast({
                    type: 'chat',
                    sender: parsedMessage.sender,
                    senderVanity: parsedMessage.senderVanity,
                    content: `<b>@ai</b> ${purify.sanitize(parsedMessage.content)}`
                });
                broadcast({
                    type: 'chat',
                    sender: 'Gemini AI',
                    senderVanity: 'Gemini AI',
                    content: randomResponse
                });
                return;
            }
            async function run() {
                try {
                    const response = await ollama.chat({
                        model: modelName,
                        messages: [{ role: 'user', content: userQuery }],
                    });
                    const text = response.message.content;
                    broadcast({
                        type: 'chat',
                        sender: parsedMessage.sender,
                        senderVanity: parsedMessage.senderVanity,
                        content: `<b>@ai</b> ${purify.sanitize(userQuery)}`
                    });
                    broadcast({
                        type: 'chat',
                        sender: 'Qwen AI',
                        senderVanity: 'Qwen AI',
                        content: text
                    });
                } catch (error) {
                    console.error('Ollama API Error:', error);
                    ws.send(JSON.stringify({
                        type: 'chat',
                        sender: 'Qwen AI',
                        senderVanity: 'Qwen AI',
                        content: 'Error processing your request. Please try again later.'
                    }));
                }
            }
            run();
        } */
    });

    ws.on('close', () => {
        if (currentUserId) {
            // Only delete if this WebSocket is still the one associated with currentUserId
            if (clients.get(ws) === currentUserId) {
                clients.delete(ws);
            }
            // Do NOT delete userVanities[currentUserId] here, as the ID should persist
            usersTyping.delete(currentUserId);
            broadcastUserList();
        }
    });
});

function broadcast(message, senderWs = null) {
    wss.clients.forEach((client) => {
        if (client !== senderWs && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

function broadcastUserList() {
    const userList = [];
    for (let [ws, id] of clients.entries()) {
        userList.push({ id: id, vanity: userVanities.get(id) });
    }
    broadcast({ type: 'userList', users: userList });
}

const os = require('os');

const interfaces = os.networkInterfaces();
const addresses = [];
for (const k in interfaces) {
    for (const k2 in interfaces[k]) {
        const address = interfaces[k][k2];
        if (address.family === 'IPv4' && !address.internal) {
            addresses.push(address.address);
        }
    }
}

server.listen(3000, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:3000/ and on your network at http://${addresses[0]}:3000/`);
});
