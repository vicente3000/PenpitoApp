import { DeviceCommand } from '../models';
import { deviceService } from './DeviceService';

type QueuedCommand = {
  command: DeviceCommand;
  resolve: (success: boolean) => void;
};

class CommandQueueService {
  private queue: QueuedCommand[] = [];
  private isProcessing = false;

  enqueue(command: DeviceCommand): Promise<boolean> {
    return new Promise((resolve) => {
      this.queue.push({ command, resolve });
      console.log(`[CommandQueue] Enqueued: ${command.cmd}=${command.val}`);
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
          console.warn('[CommandQueue] Command failed, retrying in 2s...');
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      } catch (err) {
        console.error('[CommandQueue] Error sending command', err);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    this.isProcessing = false;
  }
}

export const commandQueueService = new CommandQueueService();
