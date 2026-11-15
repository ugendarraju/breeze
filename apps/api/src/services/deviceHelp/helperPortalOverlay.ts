// fork: the Breeze Assist tray's "Open Breeze Portal" item opens this device's
// account-less Get help form. The signed helper opens `portalUrl` when it is on
// the agent's own https origin, so this is a server-only change: the policy's
// settings are cached as resolved, and the per-device link is laid over them on
// the way out (never cached, so a rotated or disabled link applies next beat).
import type { HelperSettings } from '../helperSettings';
import { getHelpLinkState, helpLinkUrl, mintHelpToken } from './helpLinkToken';

export async function withDeviceHelpPortal(deviceId: string, settings: HelperSettings): Promise<HelperSettings> {
  try {
    const state = await getHelpLinkState(deviceId);
    if (!state.enabled) return settings;
    return { ...settings, portalUrl: helpLinkUrl(mintHelpToken(deviceId, state.version)) };
  } catch {
    // Redis down or a non-uuid id: the tray keeps the policy's portal URL.
    return settings;
  }
}
