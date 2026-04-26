export type SensorSource = 'purple_air' | 'clarity' | string;

export type SensorPoint = {
  sensorIndex: number;
  latitude: number;
  longitude: number;
  pm25: number;
  source: SensorSource;
  time: string;
};
