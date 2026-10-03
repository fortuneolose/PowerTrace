import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// .env lives in the repo root (one level above /backend)
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

export const config = {
  mongoUri: process.env.MONGODB_URI,
  dbNames: {
    demo: process.env.DEMO_DB || 'powertrace_demo',
    hospital: process.env.HOSPITAL_DB || 'powertrace_hospital',
  },
  port: Number(process.env.PORT) || 3000,
  publicUrl: process.env.PUBLIC_URL || '',
};
