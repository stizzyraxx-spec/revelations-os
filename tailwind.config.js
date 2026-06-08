/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/src/**/*.{js,jsx}', './src/renderer/index.html'],
  theme: {
    extend: {
      colors: {
        accent: '#6d28d9',
        gold: '#f59e0b',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      boxShadow: {
        orb: '0 0 20px rgba(255,255,255,0.95), 0 0 50px rgba(255,255,255,0.5), 0 0 90px rgba(109,40,217,0.7)',
        glow: '0 0 40px rgba(109,40,217,0.4)',
      }
    }
  },
  plugins: []
}
