export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function unauthorized(): HttpError {
  return new HttpError(401, 'unauthorized', 'Authentication is required.');
}

export function notFound(): HttpError {
  return new HttpError(404, 'not_found', 'The requested record was not found.');
}
