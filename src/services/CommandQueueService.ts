import { DeviceCommand } from '../models';
import { deviceService } from './DeviceService';

type QueuedCommand = {
  command: DeviceCommand;
  resolve: (success: boolean) => void;
  retries: number;
};

class CommandQueueService {
  private queue: QueuedCommand[] = [];
  private isProcessing = false;
  private readonly maxRetries = 3;

  enqueue(command: DeviceCommand): Promise<boolean> {
    const cmdWithId = {
      ...command,
      requestId: command.requestId || `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    };
    return new Promise((resolve) => {
      this.queue.push({ command: cmdWithId, resolve, retries: 0 });
      console.log(`[CommandQueue] Enqueued: ${cmdWithId.cmd}=${cmdWithId.val} (${cmdWithId.requestId})`);
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;

    this.isProcessing = true;

    while (this.queue.length > 0) {
      const entry = this.queue[0];
      try {
        const success = await deviceService.sendCommand(entry.command);
        if (success) {
          this.queue.shift();
          entry.resolve(true);
        } else {
          entry.retries += 1;
          if (entry.retries >= this.maxRetries) {
            console.warn(`[CommandQueue] Command discarded after ${this.maxRetries} retries: ${entry.command.cmd}=${entry.command.val}`);
            this.queue.shift();
            entry.resolve(false);
          } else {
            console.warn(`[CommandQueue] Command failed, retrying (${entry.retries}/${this.maxRetries}) in 2s...`);
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        }
      } catch (err) {
        entry.retries += 1;
        if (entry.retries >= this.maxRetries) {
          console.error(`[CommandQueue] Command exception max retries reached. Discarding: ${entry.command.cmd}`, err);
          this.queue.shift();
          entry.resolve(false);
        } else {
          console.error(`[CommandQueue] Error sending command, retrying (${entry.retries}/${this.maxRetries}) in 2s...`, err);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }

    this.isProcessing = false;
  }

  clear(): void {
    if (this.queue.length > 0) {
      console.log(`[CommandQueue] Limpiando ${this.queue.length} comandos pendientes de la cola.`);
      while (this.queue.length > 0) {
        const entry = this.queue.shift();
        if (entry) {
          entry.resolve(false);
        }
      }
    }
  }
}

export const commandQueueService = new CommandQueueService();
