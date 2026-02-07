/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: "class",
  content: ["./src/**/*.{tsx,ts,jsx,js}"],
  theme: {
    extend: {}
  },
  plugins: [require("@tailwindcss/typography")]
}
