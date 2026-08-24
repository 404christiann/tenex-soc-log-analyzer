/**
 * Time helpers for the synthetic org's fixed business hours: 08:00-18:00 UTC,
 * Monday-Friday (DECISIONS.md §14a off-hours rule).
 */

export const BUSINESS_START_UTC_HOUR = 8;
export const BUSINESS_END_UTC_HOUR = 18;

export function isWeekdayUtc(d: Date): boolean {
  const day = d.getUTCDay(); // 0 = Sunday, 6 = Saturday
  return day >= 1 && day <= 5;
}

export function isBusinessHoursUtc(d: Date): boolean {
  const hour = d.getUTCHours();
  return isWeekdayUtc(d) && hour >= BUSINESS_START_UTC_HOUR && hour < BUSINESS_END_UTC_HOUR;
}

export function isOffHoursUtc(d: Date): boolean {
  return !isBusinessHoursUtc(d);
}

/** Adds whole seconds to a Date, returning a new Date (never mutates the input). */
export function addSeconds(d: Date, seconds: number): Date {
  return new Date(d.getTime() + seconds * 1000);
}

/** Adds whole minutes to a Date, returning a new Date. */
export function addMinutes(d: Date, minutes: number): Date {
  return addSeconds(d, minutes * 60);
}
