
import { getSettingsSchema } from './src/config/settingsSchema.ts';
const s = getSettingsSchema();
console.log('top keys:', Object.keys(s).join(','));
console.log('has properties:', !!s.properties);
console.log('prop keys sample:', s.properties ? Object.keys(s.properties).slice(0,12).join(',') : 'n/a');
