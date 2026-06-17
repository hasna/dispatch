/**
 * Scheduling helpers: parse a one-shot time or a 5-field cron expression and
 * compute the next fire time. Self-contained (no cron dependency).
 *
 * Cron fields: minute hour day-of-month month day-of-week
 *   each supports: *  a  a-b  a-b/s  * /s  and comma lists (a,b,c)
 *   day-of-week: 0-6 (0=Sunday), 7 also = Sunday
 */

export interface ScheduleSpec {
  /** One-shot absolute time (anything Date can parse, e.g. ISO 8601). */
  at?: string;
  /** Recurring 5-field cron expression. */
  cron?: string;
}

function parseField(expr: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of expr.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) throw new Error(`invalid cron step: ${part}`);
    let lo = min;
    let hi = max;
    if (rangePart && rangePart !== "*") {
      const bounds = rangePart.split("-");
      if (bounds.length === 1) {
        lo = hi = Number(bounds[0]);
      } else if (bounds.length === 2) {
        lo = Number(bounds[0]);
        hi = Number(bounds[1]);
      } else {
        throw new Error(`invalid cron range: ${part}`);
      }
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`invalid cron field: ${part}`);
    }
    for (let v = lo; v <= hi; v += step) {
      if (v < min || v > max) throw new Error(`cron value out of range: ${v} in ${expr}`);
      out.add(v);
    }
  }
  return out;
}

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Whether dom/dow were restricted (affects OR semantics). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron must have 5 fields, got ${fields.length}: "${expr}"`);
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const dowSet = parseField(dow, 0, 7);
  if (dowSet.has(7)) {
    dowSet.delete(7);
    dowSet.add(0);
  }
  return {
    minute: parseField(m, 0, 59),
    hour: parseField(h, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12),
    dow: dowSet,
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  };
}

function matches(c: ParsedCron, d: Date): boolean {
  if (!c.minute.has(d.getMinutes())) return false;
  if (!c.hour.has(d.getHours())) return false;
  if (!c.month.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  // Standard cron: when both dom and dow are restricted, either may match.
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk;
  if (c.domRestricted) return domOk;
  if (c.dowRestricted) return dowOk;
  return true;
}

/** Next time (strictly after `from`) that the cron expression matches. */
export function nextCronRun(expr: string, from: Date): Date {
  const c = parseCron(expr);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after
  const limit = from.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (d.getTime() <= limit) {
    if (matches(c, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error(`no cron match within a year for: "${expr}"`);
}

/** Compute the next fire time for a spec as an ISO string. */
export function computeNextRun(spec: ScheduleSpec, from: Date = new Date()): string {
  if (spec.at) {
    const t = new Date(spec.at);
    if (Number.isNaN(t.getTime())) throw new Error(`invalid \`at\` time: ${spec.at}`);
    return t.toISOString();
  }
  if (spec.cron) {
    return nextCronRun(spec.cron, from).toISOString();
  }
  throw new Error("schedule spec requires `at` or `cron`");
}
