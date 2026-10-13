export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function errorBody(error: AppError): {
  error: { code: string; message: string; details: Record<string, unknown> };
} {
  return {
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
  };
}
