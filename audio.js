// this is a class so that we can use EventTarget, but a singleton, as in the browser the active devices are external to React and can be managed app-wide.
class AudioDevices extends EventTarget {
  private busy = false;
  private _denied = false;
  private _devices: MediaDeviceInfo[] = [];

  get denied() {
    return this._denied;
  }
  set denied(denied) {
    if (denied !== this._denied) {
      this._denied = denied;
      this.dispatchEvent(new Event('changeDenied'));
    }
  }

  get devices() {
    return this._devices;
  }
  set devices(devices) {
    if (devices !== this._devices) {
      this._devices = devices;
      this.dispatchEvent(new Event('changeDevices'));
    }
  }

  constructor() {
    super();
    if (typeof window !== 'undefined') {
      this.updateDeviceList();
      // We don't need to unsubscribe as this class is a singleton
      navigator.mediaDevices.addEventListener('devicechange', () => {
        this.updateDeviceList();
      });
    }
  }

  // A wrapped getUserMedia that manages denied and device state
  public getUserMedia = async (constraints: MediaStreamConstraints) => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.denied = false;
    } catch (ex) {
      this.denied = true;
    }
    this.updateDeviceList();
    return stream;
  };

  // getDevices is used to prompt the user to give permission to audio inputs
  public getDevices = async () => {
    // We first check if the system is busy - we don't want to prompt for permissions if the user is already prompted for permissions
    if (!this.busy) {
      this.busy = true;
      await this.promptAudioInputs();
      this.busy = false;
    } else {
      console.warn('getDevices already in progress');
    }
  };

  // updateDeviceList is used to handle device enumeration once permissions have been given
  private updateDeviceList = async () => {
    const devices: MediaDeviceInfo[] =
      await navigator.mediaDevices.enumerateDevices();
    const filtered = devices.filter((device: MediaDeviceInfo) => {
      return (
        device.kind === 'audioinput' &&
        device.deviceId !== '' &&
        device.label !== ''
      );
    });
    this.devices = filtered;
  };

  private promptAudioInputs = async () => {
    const permissions = await getPermissions();
    if (permissions === 'denied') {
      this.denied = true;
      return;
    }

    // If permissions are prompt, we need to call getUserMedia to ask the user for permission
    if (permissions === 'prompt') {
      await this.getUserMedia({
        audio: true,
        video: false,
      });
    } else {
      this.updateDeviceList();
    }
  };
}
const audioDevices = new AudioDevices();

// getPermissions is used to access the permissions API
// This API is not fully supported in all browsers so we first check the availability of the API
async function getPermissions() {
  if (navigator?.permissions) {
    return (
      navigator.permissions
        // @ts-ignore - ignore because microphone is not in the enum of name for all browsers
        ?.query({ name: 'microphone' })
        .then((result) => result.state)
        .catch((err) => {
          return 'prompt';
        })
    );
  }
  return 'prompt';
}
