/**
 * Input validation helpers for MCP tool parameters.
 * Provides actionable error messages for non-technical users.
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * Normalizes a date string to a full ISO 8601 timestamp required by the Gong API.
 * Plain dates like "2026-02-16" become "2026-02-16T00:00:00Z".
 * Strings that already have a time component are returned unchanged.
 */
export function normalizeDateTime(value: string): string {
  return value.includes("T") ? value : `${value}T00:00:00Z`;
}

export function validateDateParam(value: string | undefined, name: string): void {
  if (value === undefined || value === "") return;
  if (!ISO_DATE_RE.test(value)) {
    throw new ValidationError(
      `"${name}" must be a valid date in ISO 8601 format (e.g. "2026-03-16" or "2026-03-16T09:00:00Z"). Got: "${value}"`
    );
  }
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new ValidationError(
      `"${name}" is not a real date. Example: "2026-03-16T09:00:00Z". Got: "${value}"`
    );
  }
}

export function validateEmail(value: string | undefined, name: string): string {
  if (!value || value.trim() === "") {
    throw new ValidationError(`"${name}" is required. Please provide an email address.`);
  }
  const trimmed = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new ValidationError(
      `"${name}" doesn't look like a valid email address. Got: "${value}"`
    );
  }
  return trimmed;
}

export function validateCallId(value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new ValidationError(
      `"callId" is required. You can find call IDs by using list_calls first.`
    );
  }
  return value.trim();
}

export function validatePositiveInt(
  value: number | undefined,
  name: string,
  defaultValue: number
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError(
      `"${name}" must be a positive whole number. Got: ${value}`
    );
  }
  return value;
}

export function validateNonNegativeInt(
  value: number | undefined,
  name: string,
  defaultValue: number
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 0) {
    throw new ValidationError(
      `"${name}" must be a non-negative whole number. Got: ${value}`
    );
  }
  return value;
}
