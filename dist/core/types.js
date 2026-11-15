export class QueueFullError extends Error {
    constructor(message = "queue is full") {
        super(message);
        this.name = "QueueFullError";
    }
}
export class QueueClosedError extends Error {
    constructor(message = "queue is closed") {
        super(message);
        this.name = "QueueClosedError";
    }
}
//# sourceMappingURL=types.js.map