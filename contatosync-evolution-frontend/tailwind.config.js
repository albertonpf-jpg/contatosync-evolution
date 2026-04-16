/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      // Tipografia sistema - sem hydration issues
      fontFamily: {
        'sans': ['system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        'serif': ['Georgia', 'Times New Roman', 'serif'],
        'mono': ['SFMono-Regular', 'Consolas', 'Liberation Mono', 'monospace']
      },

      // Espacamento base de 8px - REGRA MAIS IMPORTANTE
      spacing: {
        'space': '8px',
        '1.5': '12px',
        '2.5': '20px',
        '3.5': '28px',
        '4.5': '36px',
        '5.5': '44px',
        '6.5': '52px',
        '7.5': '60px',
        '8.5': '68px',
        '9.5': '76px',
        '10.5': '84px',
        '12.5': '100px',
        '15': '120px',
        '18': '144px',
        '22': '176px',
        '26': '208px',
        '30': '240px'
      },

      // Cores premium - nunca genérico
      colors: {
        primary: {
          50: '#f0f9ff',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          800: '#1e40af',
          900: '#1e3a8a'
        },
        accent: {
          400: '#f59e0b',
          500: '#d97706',
          600: '#b45309'
        },
        dark: {
          bg: '#0a0a0f',
          card: '#1a1a24',
          border: 'rgba(255,255,255,0.06)'
        },
        light: {
          bg: '#fefefe',
          card: '#ffffff',
          border: 'rgba(0,0,0,0.08)'
        }
      },

      // Tipografia hierárquica obrigatória
      fontSize: {
        'display-2xl': ['80px', { lineHeight: '1.1', fontWeight: '900' }],
        'display-xl': ['64px', { lineHeight: '1.1', fontWeight: '800' }],
        'display-lg': ['56px', { lineHeight: '1.1', fontWeight: '700' }],
        'heading-xl': ['48px', { lineHeight: '1.2', fontWeight: '700' }],
        'heading-lg': ['36px', { lineHeight: '1.2', fontWeight: '600' }],
        'heading-md': ['28px', { lineHeight: '1.3', fontWeight: '600' }],
        'body-lg': ['18px', { lineHeight: '1.6' }],
        'body': ['16px', { lineHeight: '1.6' }],
        'label': ['14px', { lineHeight: '1.4', letterSpacing: '0.05em' }],
        'caption': ['12px', { lineHeight: '1.4', letterSpacing: '0.05em' }]
      },

      // Sombras para profundidade
      boxShadow: {
        'card': '0 4px 20px rgba(0, 0, 0, 0.08)',
        'card-hover': '0 8px 40px rgba(0, 0, 0, 0.12)',
        'card-dark': '0 20px 60px rgba(0, 0, 0, 0.4)',
        'button': '0 4px 12px rgba(59, 130, 246, 0.3)'
      },

      // Border radius consistente
      borderRadius: {
        'sm': '8px',
        'md': '12px',
        'lg': '20px',
        'xl': '24px'
      },

      // Animações suaves
      animation: {
        'fade-in': 'fadeIn 0.5s ease-out',
        'slide-up': 'slideUp 0.5s ease-out',
        'stagger': 'fadeIn 0.5s ease-out',
      },

      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(30px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        }
      },

      // Container máximo e padding
      container: {
        center: true,
        padding: '24px',
        screens: {
          '2xl': '1200px'
        }
      }
    },
  },
  plugins: [],
}