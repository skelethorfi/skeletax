export interface DateRange {
  from: string;
  to: string;
}

function isIsoDateString(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

// A YYYY-MM-DD date that is on the calendar: "2023-02-30" is not (Date would roll it to 2 March)
export function isCalendarDate(date: unknown): date is string {
  if (typeof date !== "string" || !isIsoDateString(date)) {
    return false;
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return isValid(parsed) && parsed.toISOString().slice(0, 10) === date;
}

function isValid(date: Date): boolean {
  return !isNaN(date.getTime());
}

class DateParts {
  year: number;
  month: number;
  day: number;

  constructor(date: string) {
    const [year, month, day] = date.split("-").map((n) => parseInt(n, 10));
    this.year = year;
    this.month = month;
    this.day = day;
  }

  toUTCDate(): Date {
    return new Date(Date.UTC(this.year, this.month - 1, this.day));
  }

  toString(): string {
    return this.toUTCDate().toISOString().slice(0, 10);
  }

  clone(): DateParts {
    return new DateParts(this.toString());
  }

  // Converts to UTC date so facilitates month overflow, and day 0 rolling back to previous month
  static toDateParts(year: number, month: number, day: number): DateParts {
    return new DateParts(new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10));
  }

  lastDayOfMonth(): DateParts {
    // Day 0 of next month = last day of this month
    return DateParts.toDateParts(this.year, this.month + 1, 0);
  }

  addDays(days: number): DateParts {
    return DateParts.toDateParts(this.year, this.month, this.day + days);
  }

  addYears(years: number): DateParts {
    return DateParts.toDateParts(this.year + years, this.month, this.day);
  }

  isAfter(other: DateParts) {
    return this.toUTCDate().getTime() > other.toUTCDate().getTime();
  }
}

/**
 * Generates an array of date ranges between `fromDate` and `toDate`.
 * Only accepts ISO date strings - YYYY-MM-DD.
 *
 * monthly: calendar month boundaries
 * yearly:  12-month blocks starting from fromDate
 */
export function generateDateRanges(
  fromDate: string,
  toDate: string,
  frequency: "monthly" | "yearly" | "none",
): DateRange[] {
  const startDate = new Date(fromDate);
  const endDate = new Date(toDate);

  if (!isCalendarDate(fromDate)) {
    throw new Error("Invalid fromDate");
  }

  if (!isCalendarDate(toDate)) {
    throw new Error("Invalid toDate");
  }

  if (startDate > endDate) {
    throw new Error("fromDate must be earlier than toDate");
  }

  const ranges: DateRange[] = [];

  const start: DateParts = new DateParts(fromDate);
  const end: DateParts = new DateParts(toDate);

  if (frequency === "none") {
    return [{ from: start.toString(), to: end.toString() }];
  }

  let periodStart: DateParts = start;
  let periodEnd: DateParts;

  while (!periodStart.isAfter(end)) {
    if (frequency === "monthly") {
      periodEnd = periodStart.lastDayOfMonth();
    } else if (frequency === "yearly") {
      periodEnd = periodStart.addYears(1).addDays(-1);
    } else {
      throw new Error(`Unknown frequency: ${frequency}`);
    }

    if (periodEnd.isAfter(end)) {
      periodEnd = end.clone();
    }

    ranges.push({ from: periodStart.toString(), to: periodEnd.toString() });

    // Move to the next day after periodEnd
    periodStart = periodEnd.addDays(1);
  }

  return ranges;
}

// The instant a calendar day (YYYY-MM-DD) starts in an IANA time zone, e.g. 'Europe/London', in ms
export function startOfDay(date: string, timeZone: string = "UTC"): number {
  const utcMidnight = new Date(`${date}T00:00:00.000Z`).getTime();

  if (!isIsoDateString(date) || isNaN(utcMidnight)) {
    throw new Error(`Invalid date: ${date}`);
  }

  // Local midnight is UTC midnight less the zone's offset; the offset is read again at that instant in
  // case it differs there (a daylight-saving change between the two)
  const guess = utcMidnight - offsetMs(utcMidnight, timeZone);
  return utcMidnight - offsetMs(guess, timeZone);
}

// The calendar day after a YYYY-MM-DD date
export function nextDay(date: string): string {
  return new Date(new Date(`${date}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000).toISOString().substring(0, 10);
}

// The calendar date (YYYY-MM-DD) of an instant in an IANA time zone
export function dateIn(time: Date, timeZone: string = "UTC"): string {
  const { year, month, day } = zoneParts(time.getTime(), timeZone);
  return `${year}-${month}-${day}`;
}

// Throws unless the name is a time zone this runtime knows, e.g. 'UTC' or 'Europe/London'
export function checkTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(`Unknown timezone: ${timeZone} (use an IANA name such as "Europe/London")`);
  }
}

// The zone's offset from UTC at an instant, in ms (+9 h for Asia/Tokyo)
function offsetMs(time: number, timeZone: string): number {
  const { year, month, day, hour, minute, second } = zoneParts(time, timeZone);
  const local = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return local - Math.floor(time / 1000) * 1000;
}

function zoneParts(time: number, timeZone: string): Record<string, string> {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return Object.fromEntries(format.formatToParts(new Date(time)).map((part) => [part.type, part.value]));
}
