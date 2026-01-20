/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Inside Out Technologies brand colors
        'brand-1': 'rgb(204, 255, 0)', // Fluor Lemon Zest - bright yellow/green
        'brand-2': 'rgb(2, 125, 94)',  // Fresh Leaf - green
        'brand-3': 'rgb(0, 66, 56)',   // Keepin' the Planet Green - dark green
        'brand-4': 'rgb(54, 69, 255)', // System Shok Blue - blue
        'dark-1': 'rgb(0, 66, 56)',    // Dark green
        'dark-2': 'rgb(18, 22, 24)',   // Dark gray/black
        'light-1': 'rgb(234, 233, 229)', // Soft concrete - light gray
        'light-2': 'rgb(255, 255, 255)', // White
      },
      fontFamily: {
        'haffer': ['Haffer SQ', 'sans-serif'],
      },
      fontWeight: {
        'regular': '400',
        'medium': '500',
        'bold': '700',
        'heavy': '900',
      },
    },
  },
  plugins: [],
}
