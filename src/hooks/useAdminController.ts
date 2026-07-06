/**
 * useAdminController: puente entre la app y el controller para comandos
 * administrativos (POWER ON/OFF, CLEAN, SET_CALIB, TEST_HW, EMERGENCY_STOP,
 * CONFIG_WIFI).
 *
 * La app no publica directo al ESP32: publica en `mobile/admin/command` y
 * espera un CommandAck correlacionado por commandId. El controller es el
 * único que publica en `controller/hardware/command`.
 */

import { useCallback } from 'react';
import { deviceService } from '../services/DeviceService';
import { CommandAck, CommandEnvelope, PROTOCOL_VERSION } from '../protocol/types';

function makeCommandId(): string {
  return `admin_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
}

export interface AdminControllerApi {
  sendAdminCommand: (
    type: CommandEnvelope['type'],
    payload?: Record<string, unknown>,
    timeoutMs?: number
  ) => Promise<CommandAck>;
  powerOn: () => Promise<CommandAck>;
  powerOff: () => Promise<CommandAck>;
  emergencyStop: () => Promise<CommandAck>;
  clean: () => Promise<CommandAck>;
  testHardware: (payload: Record<string, unknown>) => Promise<CommandAck>;
  setCalibration: (rates: number[], positions: number[]) => Promise<CommandAck>;
  configWifi: (ssid: string, password: string, mqttHost: string, mqttPort: number) => Promise<CommandAck>;
  sendTestMotorAbs: (pos: number) => Promise<CommandAck>;
  sendTestPump: (pin: number, durationMs: number) => Promise<CommandAck>;
  sendTestServo: (pin: number, angle: number) => Promise<CommandAck>;
  sendTestMotor: (steps: number) => Promise<CommandAck>;
  sendTestServoCont: (pin: number, angle: number) => Promise<CommandAck>;
  sendTestMotorHome: () => Promise<CommandAck>;
  sendTestFull: () => Promise<CommandAck>;
  sendTestDry: () => Promise<CommandAck>;
  sendTestVaso: () => Promise<CommandAck>;
  sendTestHielo: () => Promise<CommandAck>;
  sendTestCuchara: () => Promise<CommandAck>;
}

export function useAdminController(): AdminControllerApi {
  const sendAdminCommand = useCallback(
    (type: CommandEnvelope['type'], payload?: Record<string, unknown>, timeoutMs?: number) => {
      const envelope: CommandEnvelope = {
        protocolVersion: PROTOCOL_VERSION,
        commandId: makeCommandId(),
        type,
        issuedBy: 'mobile',
        issuedAt: Date.now(),
      };
      if (payload) envelope.payload = payload;
      return deviceService.penpitoAdapter.submitAdminCommand(envelope, timeoutMs);
    },
    []
  );

  return {
    sendAdminCommand,
    powerOn: () => sendAdminCommand('POWER', { val: 'ON' }),
    powerOff: () => sendAdminCommand('POWER', { val: 'OFF' }),
    emergencyStop: () => sendAdminCommand('EMERGENCY_STOP'),
    clean: () => sendAdminCommand('CLEAN'),
    testHardware: (payload) => sendAdminCommand('TEST_HW', payload),
    setCalibration: (rates, positions) => sendAdminCommand('SET_CALIB', { rates, positions }),
    configWifi: (ssid, password, mqttHost, mqttPort) => sendAdminCommand('CONFIG_WIFI', { ssid, password, mqttHost, mqttPort }),
    sendTestMotorAbs: (pos) => sendAdminCommand('TEST_HW', { type: 'motor_abs', val: pos }),
    sendTestPump: (pin, durationMs) => sendAdminCommand('TEST_HW', { type: 'pump', pin, duration: durationMs }),
    sendTestServo: (pin, angle) => sendAdminCommand('TEST_HW', { type: 'servo', pin, val: angle }),
    sendTestMotor: (steps) => sendAdminCommand('TEST_HW', { type: 'motor', val: steps }),
    sendTestServoCont: (pin, angle) => sendAdminCommand('TEST_HW', { type: 'servo_cont', pin, val: angle }),
    sendTestMotorHome: () => sendAdminCommand('TEST_HW', { type: 'motor_home' }),
    sendTestFull: () => sendAdminCommand('TEST_HW', { type: 'full_test' }),
    sendTestDry: () => sendAdminCommand('TEST_HW', { type: 'dry_test' }),
    sendTestVaso: () => sendAdminCommand('TEST_HW', { type: 'vaso_test' }),
    sendTestHielo: () => sendAdminCommand('TEST_HW', { type: 'hielo_test' }),
    sendTestCuchara: () => sendAdminCommand('TEST_HW', { type: 'cuchara_test' }),
  };
}
