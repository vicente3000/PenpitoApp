import { commandQueueService } from '../../services/CommandQueueService';
import { deviceService } from '../../services/DeviceService';
import { DeviceCommand } from '../../models';

jest.mock('../../services/DeviceService', () => ({
  deviceService: {
    sendCommand: jest.fn(),
  },
}));

describe('CommandQueueService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    commandQueueService.clear();
  });

  const mockCommand: DeviceCommand = {
    cmd: 'PREPARE',
    val: 'negroni',
    iceCount: 3,
  };

  describe('enqueue', () => {
    it('should process a single command successfully', async () => {
      (deviceService.sendCommand as jest.Mock).mockResolvedValue(true);

      const result = await commandQueueService.enqueue(mockCommand);

      expect(result).toBe(true);
      expect(deviceService.sendCommand).toHaveBeenCalledTimes(1);
      expect(deviceService.sendCommand).toHaveBeenCalledWith(
        expect.objectContaining({ cmd: 'PREPARE', val: 'negroni', iceCount: 3 })
      );
    });

    it('should auto-generate a requestId if not provided', async () => {
      (deviceService.sendCommand as jest.Mock).mockResolvedValue(true);

      await commandQueueService.enqueue(mockCommand);

      const sentCommand = (deviceService.sendCommand as jest.Mock).mock.calls[0][0];
      expect(sentCommand.requestId).toBeDefined();
      expect(sentCommand.requestId).toMatch(/^cmd-\d+-[a-f0-9]+$/);
    });

    it('should keep the provided requestId', async () => {
      (deviceService.sendCommand as jest.Mock).mockResolvedValue(true);

      await commandQueueService.enqueue({ ...mockCommand, requestId: 'my-custom-id' });

      const sentCommand = (deviceService.sendCommand as jest.Mock).mock.calls[0][0];
      expect(sentCommand.requestId).toBe('my-custom-id');
    });

    it('should process commands sequentially', async () => {
      const order: number[] = [];
      (deviceService.sendCommand as jest.Mock).mockImplementation(async () => {
        order.push(order.length + 1);
        return true;
      });

      const r1 = await commandQueueService.enqueue({ ...mockCommand, val: 'first' });
      const r2 = await commandQueueService.enqueue({ ...mockCommand, val: 'second' });
      const r3 = await commandQueueService.enqueue({ ...mockCommand, val: 'third' });

      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(r3).toBe(true);
      expect(order).toEqual([1, 2, 3]);
      expect(deviceService.sendCommand).toHaveBeenCalledTimes(3);
    });
  });

  describe('retry behavior', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should retry up to 3 times on failure then resolve false', async () => {
      (deviceService.sendCommand as jest.Mock).mockResolvedValue(false);

      const promise = commandQueueService.enqueue(mockCommand);

      await jest.advanceTimersByTimeAsync(0);
      expect(deviceService.sendCommand).toHaveBeenCalledTimes(1);

      // Retry 1
      await jest.advanceTimersByTimeAsync(2000);
      expect(deviceService.sendCommand).toHaveBeenCalledTimes(2);

      // Retry 2 (maxRetries=3 means 1 initial + 2 retries before discard)
      await jest.advanceTimersByTimeAsync(2000);
      expect(deviceService.sendCommand).toHaveBeenCalledTimes(3);

      const result = await promise;
      expect(result).toBe(false);
    });

    it('should succeed on second attempt after first failure', async () => {
      let calls = 0;
      (deviceService.sendCommand as jest.Mock).mockImplementation(async () => {
        calls++;
        return calls >= 2;
      });

      const promise = commandQueueService.enqueue(mockCommand);

      await jest.advanceTimersByTimeAsync(0);
      expect(deviceService.sendCommand).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(2000);
      expect(deviceService.sendCommand).toHaveBeenCalledTimes(2);

      const result = await promise;
      expect(result).toBe(true);
    });

    it('should retry on exceptions and eventually discard', async () => {
      (deviceService.sendCommand as jest.Mock).mockRejectedValue(new Error('fail'));

      const promise = commandQueueService.enqueue(mockCommand);

      await jest.advanceTimersByTimeAsync(0);
      expect(deviceService.sendCommand).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(2000);
      await jest.advanceTimersByTimeAsync(2000);

      const result = await promise;
      expect(result).toBe(false);
    });
  });

  describe('clear', () => {
    it('should drain all pending commands with false resolution', async () => {
      (deviceService.sendCommand as jest.Mock).mockImplementation(
        () => new Promise(() => {}) // hangs forever
      );

      const p1 = commandQueueService.enqueue(mockCommand);
      const p2 = commandQueueService.enqueue({ ...mockCommand, val: 'second' });

      // Esperar un poco a que entren a la cola
      await new Promise(r => setTimeout(r, 10));

      commandQueueService.clear();

      const results = await Promise.all([p1, p2]);
      expect(results).toEqual([false, false]);
    });
  });
});
