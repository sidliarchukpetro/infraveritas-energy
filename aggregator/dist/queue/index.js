import { EventEmitter } from "node:events";
export class InMemoryQueue extends EventEmitter {
    records = new Map();
    pending = [];
    enqueue(id, data) {
        if (this.records.has(id)) {
            throw new Error(`Job ${id} already exists`);
        }
        const record = {
            id,
            data,
            status: "pending",
            attempts: 0,
            enqueuedAt: new Date(),
        };
        this.records.set(id, record);
        this.pending.push(id);
        this.emit("enqueued", id);
        return record;
    }
    claim() {
        const id = this.pending.shift();
        if (!id)
            return null;
        const record = this.records.get(id);
        if (!record)
            return null;
        record.status = "processing";
        record.attempts += 1;
        record.startedAt = new Date();
        return record;
    }
    complete(id, result) {
        const record = this.records.get(id);
        if (!record)
            return;
        record.status = "complete";
        record.result = result;
        record.finishedAt = new Date();
        this.emit("completed", id, result);
    }
    fail(id, code, message, maxAttempts = 3) {
        const record = this.records.get(id);
        if (!record)
            return;
        record.error = { code, message };
        if (record.attempts < maxAttempts) {
            record.status = "pending";
            this.pending.push(id);
        }
        else {
            record.status = "failed";
            record.finishedAt = new Date();
            this.emit("failed", id, record.error);
        }
    }
    quarantine(id, code, message) {
        const record = this.records.get(id);
        if (!record)
            return;
        record.status = "quarantined";
        record.error = { code, message };
        record.finishedAt = new Date();
        this.emit("quarantined", id, record.error);
    }
    get(id) {
        return this.records.get(id);
    }
    size() {
        let processing = 0;
        for (const r of this.records.values()) {
            if (r.status === "processing")
                processing += 1;
        }
        return {
            total: this.records.size,
            pending: this.pending.length,
            processing,
        };
    }
}
