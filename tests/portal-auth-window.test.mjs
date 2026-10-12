import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PortalAuthWindow } from '../electron/portal-auth-window.mjs';

for (const backgroundColor of [undefined, '#171A19']) {
  test('Окно входа сохраняет стандартный фон или принимает тему Кузьмича: ' + backgroundColor, () => {
    let options;
    const auth = new PortalAuthWindow({ backgroundColor, createWindow: config => {
      options = config;
      const window = new EventEmitter();
      window.isDestroyed = () => false;
      window.destroy = () => window.emit('closed');
      window.webContents = new EventEmitter();
      window.webContents.session = new EventEmitter();
      window.webContents.setWindowOpenHandler = () => {};
      window.webContents.loadURL = async () => {};
      return window;
    } });
    auth.show({ url: 'https://coder-portal.encycam.com/auth/login?next=%2F' });
    assert.equal(options.title, 'Вход в Portal');
    assert.equal(Object.hasOwn(options, 'backgroundColor'), backgroundColor !== undefined);
    if (backgroundColor !== undefined) assert.equal(options.backgroundColor, '#171A19');
    assert.equal(options.webPreferences.nodeIntegration, false);
    assert.equal(options.webPreferences.sandbox, true);
    auth.close();
    assert.equal(auth.open, false);
  });
}
