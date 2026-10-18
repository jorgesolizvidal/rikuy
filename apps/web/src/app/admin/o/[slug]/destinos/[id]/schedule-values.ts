import type { EventSchedule } from "@rikuy/core";

/*
 * Plain helpers shared by the event editor page (server) and its fields (client): kept
 * out of the "use client" module so the server can call them.
 */

/** What the date and time inputs hold (local time of the municipality). */
export interface ScheduleValues {
  readonly allDay: boolean;
  readonly startDate: string;
  readonly startTime: string;
  readonly endDate: string;
  readonly endTime: string;
}

export const EMPTY_SCHEDULE: ScheduleValues = {
  allDay: false,
  startDate: "",
  startTime: "",
  endDate: "",
  endTime: "",
};

export function scheduleValues(schedule: EventSchedule | null): ScheduleValues {
  if (schedule === null) return EMPTY_SCHEDULE;
  return {
    allDay: schedule.allDay,
    startDate: schedule.start.slice(0, 10),
    startTime: schedule.allDay ? "" : schedule.start.slice(11, 16),
    endDate: schedule.end.slice(0, 10),
    endTime: schedule.allDay ? "" : schedule.end.slice(11, 16),
  };
}

/** The schedule to send, or null while no start date is chosen. */
export function toSchedule(values: ScheduleValues): EventSchedule | null {
  if (values.startDate === "") return null;
  const endDate = values.endDate || values.startDate;
  if (values.allDay) return { allDay: true, start: values.startDate, end: endDate };
  const startTime = values.startTime || "00:00";
  return {
    allDay: false,
    start: `${values.startDate}T${startTime}`,
    end: `${endDate}T${values.endTime || startTime}`,
  };
}
