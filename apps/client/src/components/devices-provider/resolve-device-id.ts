type TDevice = Pick<MediaDeviceInfo, 'deviceId'> | undefined;

// enumeration may hide a saved device until permission is granted or it reconnects.
const resolveDeviceId = (
  savedId: string | undefined,
  availableDevices: TDevice[]
): string => {
  if (savedId) return savedId;
  const defaultDevice = availableDevices.find(
    (device) => device?.deviceId === 'default'
  );
  return defaultDevice?.deviceId ?? availableDevices[0]?.deviceId ?? 'default';
};

export { resolveDeviceId };
