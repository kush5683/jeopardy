/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        jeopardy: {
          blue: "#060CE9",
          darkblue: "#040983",
          gold: "#D69F4C",
          cream: "#FFF8DC",
        },
      },
      fontFamily: {
        category: ['"Bebas Neue"', "Impact", "sans-serif"],
        clue: ['"Korinna"', "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};
