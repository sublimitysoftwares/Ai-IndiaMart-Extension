// Time and delay utility functions

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const randomBetween = (min: number, max: number): number =>
  Math.random() * (max - min) + min;

export const randomIntBetween = (min: number, max: number): number =>
  Math.floor(randomBetween(min, max + 1));

export const calculateNextMidnight = (): number => {
  const now = new Date();
  const next = new Date(now);
  next.setDate(now.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next.getTime();
};

export const getTodayIdentifier = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return {
    dateKey: `${year}-${month}-${day}`,
    dayOfWeek: now.getDay(),
  };
};

export const describeScheduleWindow = (isWorkingHours: boolean): string =>
  isWorkingHours ? '09:00-21:00' : '21:00-09:00';

export const getStealthDelayMs = (): number => {
  // Fixed 120 second refresh interval (2 minutes)
  const delaySeconds = 120;
  return delaySeconds * 1000; // 120 seconds in milliseconds
};