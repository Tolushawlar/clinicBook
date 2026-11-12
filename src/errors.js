export class BookingError extends Error {
  constructor(status, message, headers = {}) {
    super(message);
    this.name = "BookingError";
    this.status = status;
    this.headers = headers;
  }
}
