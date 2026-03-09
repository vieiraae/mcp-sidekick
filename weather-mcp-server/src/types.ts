export interface GeocodingResult {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  elevation?: number;
  timezone: string;
  country_code?: string;
  country?: string;
  admin1?: string;
  admin2?: string;
  population?: number;
  feature_code?: string;
}

export interface GeocodingResponse {
  results?: GeocodingResult[];
}

export interface ForecastResponse {
  latitude: number;
  longitude: number;
  elevation: number;
  timezone: string;
  timezone_abbreviation: string;
  utc_offset_seconds: number;
  current?: Record<string, unknown>;
  current_units?: Record<string, string>;
  hourly?: Record<string, unknown[]>;
  hourly_units?: Record<string, string>;
  daily?: Record<string, unknown[]>;
  daily_units?: Record<string, string>;
}
