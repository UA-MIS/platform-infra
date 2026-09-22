import type { Config } from 'tailwindcss';

// Tailwind scans these globs for class names. Add paths here if you put components
// outside src/.
const config: Config = {
  content: [
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};

export default config;
