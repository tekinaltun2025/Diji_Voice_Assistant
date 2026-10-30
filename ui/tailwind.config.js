/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        diji: {
          primary: '#3b82f6',
          secondary: '#8b5cf6',
          background: '#0f172a',
          surface: '#1e293b',
          text: '#f8fafc',
        },
      },
    },
  },
  plugins: [],
};