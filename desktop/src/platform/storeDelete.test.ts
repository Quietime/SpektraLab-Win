// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { browserPlatform } from './browser';

describe('platform store deletion', () => {
  it('only removes generated LightTable metadata chunks', async () => {
    const platform = browserPlatform();
    const name = 'tray-tray-mh0-abc123-photos-mh1-x8k21z4v-0.json';
    await platform.storeWrite('LightTable', name, ['record']);
    await platform.storeDelete('LightTable', name);
    await expect(platform.storeRead('LightTable', name)).resolves.toBeNull();
    await expect(platform.storeDelete('OtherArea', name)).rejects.toThrow('unmanaged');
    await expect(platform.storeDelete('LightTable', 'layout.json')).rejects.toThrow('unmanaged');
    await expect(platform.storeDelete('LightTable', '../outside.json')).rejects.toThrow('unmanaged');
  });
});
