import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0a0a0a",
        paper: "#fafaf9",
        accent: "#f7931a", // bitcoin orange
      },
    },
  },
  plugins: [],
} satisfies Config;
