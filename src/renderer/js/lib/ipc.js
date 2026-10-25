// Thin wrapper over the preload bridge with readable error messages.
const bridge = window.kiln;

export const platform = bridge.platform;
export const isMac = platform === 'darwin';

export async function invoke(channel, ...args) {
  try {
    return await bridge.invoke(channel, ...args);
  } catch (err) {
    const msg = String((err && err.message) || err).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
    const e = new Error(msg);
    e.channel = channel;
    throw e;
  }
}

export const send = (channel, ...args) => bridge.send(channel, ...args);
export const on = (channel, cb) => bridge.on(channel, cb);
export const pathForFile = (file) => bridge.pathForFile(file);
