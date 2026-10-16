import { inBBox, M_TO_FT, MS_TO_FPM, MS_TO_KT } from './geo';
import { trackAltitudeM } from './tracks';
import type { AlertEvent, AlertKind, AlertRule, Track } from './types';

export const ALERT_KINDS: { kind: AlertKind; label: string; unit: string; needsValue: boolean }[] = [
  { kind: 'squawk-emergency', label: 'Emergency squawk (7500/7600/7700)', unit: '', needsValue: false },
  { kind: 'altitude-below', label: 'Airborne below altitude', unit: 'ft', needsValue: true },
  { kind: 'altitude-above', label: 'Above altitude', unit: 'ft', needsValue: true },
  { kind: 'speed-above', label: 'Ground speed above', unit: 'kt', needsValue: true },
  { kind: 'speed-below', label: 'Airborne speed below', unit: 'kt', needsValue: true },
  { kind: 'vrate-below', label: 'Descent rate steeper than', unit: 'ft/min', needsValue: true },
  { kind: 'enter-zone', label: 'Enters zone', unit: '', needsValue: false },
];

const EMERGENCY: Record<string, string> = { '7500': 'hijack', '7600': 'radio failure', '7700': 'general emergency' };

export const DEFAULT_RULES: AlertRule[] = [
  { id: 'r-emergency', kind: 'squawk-emergency', enabled: true, value: 0 },
  { id: 'r-low', kind: 'altitude-below', enabled: false, value: 1500 },
  { id: 'r-fast', kind: 'speed-above', enabled: false, value: 550 },
  { id: 'r-descent', kind: 'vrate-below', enabled: false, value: -4000 },
];

/** Returns a human message when the rule's condition holds for the aircraft, else null. */
function check(rule: AlertRule, t: Track): string | null {
  const s = t.latest;
  const alt = trackAltitudeM(s);
  const altFt = alt === null ? null : alt * M_TO_FT;
  const kt = s.velocity === null ? null : s.velocity * MS_TO_KT;
  switch (rule.kind) {
    case 'squawk-emergency':
      return s.squawk && EMERGENCY[s.squawk] ? `squawking ${s.squawk} (${EMERGENCY[s.squawk]})` : null;
    case 'altitude-below':
      return !s.onGround && altFt !== null && altFt < rule.value ? `below ${rule.value} ft (${Math.round(altFt)} ft)` : null;
    case 'altitude-above':
      return altFt !== null && altFt > rule.value ? `above ${rule.value} ft (${Math.round(altFt)} ft)` : null;
    case 'speed-above':
      return kt !== null && kt > rule.value ? `faster than ${rule.value} kt (${Math.round(kt)} kt)` : null;
    case 'speed-below':
      return !s.onGround && kt !== null && kt < rule.value ? `slower than ${rule.value} kt (${Math.round(kt)} kt)` : null;
    case 'vrate-below': {
      const fpm = s.verticalRate === null ? null : s.verticalRate * MS_TO_FPM;
      return fpm !== null && fpm < rule.value ? `descending at ${Math.round(fpm)} ft/min` : null;
    }
    case 'enter-zone':
      return rule.zone && s.lat !== null && s.lon !== null && inBBox(rule.zone, s.lat, s.lon)
        ? `inside zone ${rule.label ?? ''}`.trim()
        : null;
  }
}

/**
 * Edge-triggered evaluation: an event fires when a condition becomes true for an
 * aircraft, and can fire again only after the condition has cleared.
 */
export function evaluateAlerts(
  rules: AlertRule[],
  tracks: Map<string, Track>,
  active: Set<string>,
  now: number,
): { events: AlertEvent[]; active: Set<string> } {
  const nextActive = new Set<string>();
  const events: AlertEvent[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const t of tracks.values()) {
      if (t.status === 'stale' && t.missedPolls > 0) continue;
      const msg = check(rule, t);
      if (!msg) continue;
      const key = `${rule.id}:${t.icao24}`;
      nextActive.add(key);
      if (!active.has(key)) {
        events.push({
          id: `${key}:${now}`,
          ruleId: rule.id,
          icao24: t.icao24,
          callsign: t.latest.callsign,
          message: msg,
          at: now,
        });
      }
    }
  }
  return { events, active: nextActive };
}
