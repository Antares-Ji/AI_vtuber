'use strict';
const { McpServer } = require('@modelcontextprotocol/server');
const { StdioServerTransport } = require('@modelcontextprotocol/server/stdio');
const { z } = require('zod');
const OBSWebSocket = require('obs-websocket-js').default;
const fs = require('node:fs');

function createServer() {
  const server = new McpServer({ name: 'suige-obs', version: '0.1.0' });
  const obs = new OBSWebSocket();
  let ready = false, connecting;
  obs.on('ConnectionClosed', () => { ready = false; });
  async function call(type, args = {}) {
    if (!ready) {
      if (!connecting) connecting = (async () => {
        const url = new URL(process.env.OBS_WEBSOCKET_URL || 'ws://127.0.0.1:4455');
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Only local OBS is supported');
        const config = process.env.OBS_CONFIG_FILE ? JSON.parse(fs.readFileSync(process.env.OBS_CONFIG_FILE, 'utf8')) : {};
        await obs.connect(url.href, process.env.OBS_WEBSOCKET_PASSWORD || config.server_password || undefined);
        ready = true;
      })().finally(() => { connecting = null; });
      await connecting;
    }
    return obs.call(type, args);
  }
  function tool(name, description, shape, handler, readOnly = true) {
    server.registerTool(name, { description, inputSchema: z.strictObject(shape), annotations: { readOnlyHint: readOnly, openWorldHint: false } }, async args => {
      try { return { content: [{ type: 'text', text: JSON.stringify((await handler(args)) ?? { ok: true }) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
    });
  }
  tool('obs_status', 'Read local OBS version, scenes and recording state.', {}, async () => ({ version: await call('GetVersion'), scenes: await call('GetSceneList'), recording: await call('GetRecordStatus') }));
  tool('obs_inputs', 'List sources and supported input kinds.', {}, async () => ({ inputs: await call('GetInputList'), kinds: await call('GetInputKindList') }));
  tool('obs_create_scene', 'Create a new local scene without overwriting existing scenes.', { sceneName: z.string().min(1) }, args => call('CreateScene', args), false);
  tool('obs_windows', 'List actual capturable windows for an existing window-capture source. Use the returned itemValue verbatim.', { inputName: z.string().min(1) }, args => call('GetInputPropertiesListPropertyItems', { ...args, propertyName: 'window' }));
  tool('obs_create_capture', 'Create a new window capture in an existing scene; does not overwrite sources. Then call obs_windows.', { sceneName: z.string().min(1), inputName: z.string().min(1) }, args => call('CreateInput', { ...args, inputKind: 'window_capture', inputSettings: {}, sceneItemEnabled: true }), false);
  tool('obs_select_window', 'Bind an existing capture source to a window value returned by obs_windows.', { inputName: z.string().min(1), window: z.string().min(1) }, async args => {
    const list = await call('GetInputPropertiesListPropertyItems', { inputName: args.inputName, propertyName: 'window' });
    if (!list.propertyItems.some(item => item.itemValue === args.window && item.itemEnabled !== false)) throw new Error('Window no longer available');
    await call('SetInputSettings', { inputName: args.inputName, inputSettings: { window: args.window }, overlay: true });
    return call('GetInputSettings', { inputName: args.inputName });
  }, false);
  tool('obs_scene', 'Switch the local program scene.', { sceneName: z.string().min(1) }, args => call('SetCurrentProgramScene', args), false);
  tool('obs_record', 'Start or stop local recording. Stop returns the saved output path. Does not start streaming.', { action: z.enum(['start', 'stop']) }, args => call(args.action === 'start' ? 'StartRecord' : 'StopRecord'), false);
  tool('obs_virtual_camera', 'Start or stop the virtual camera for the live panel.', { action: z.enum(['start', 'stop']) }, args => call(args.action === 'start' ? 'StartVirtualCam' : 'StopVirtualCam'), false);
  server.registerTool('obs_preview', { description: 'Read a source screenshot to verify real captured pixels.', inputSchema: z.strictObject({ sourceName: z.string().min(1) }) }, async args => {
    try {
      const result = await call('GetSourceScreenshot', { ...args, imageFormat: 'png', imageWidth: 960 });
      return { content: [{ type: 'image', mimeType: 'image/png', data: result.imageData.split(',')[1] }] };
    } catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  return server;
}
if (require.main === module) createServer().connect(new StdioServerTransport()).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createServer };
