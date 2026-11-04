import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  // No máximo 2 arquivos de teste ao mesmo tempo, em qualquer máquina: o banco gratuito tem pouca memória.
  workers: 2,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './tests/global-setup.mjs',
  use: {
    baseURL: 'http://localhost:4173/',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    serviceWorkers: 'block', // cada teste começa sem cache do app
    // No GitHub (repositório público) não grava o rastro técnico: ele guardaria os tokens das contas de teste.
    trace: process.env.CI ? 'off' : 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Servidor local que imita o GitHub Pages (inclusive o 404.html).
  webServer: {
    command: 'node tests/server.mjs 4173',
    url: 'http://localhost:4173/',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'android', use: { ...devices['Pixel 7'] }, testMatch: /(site|members|birthdays|agenda|privacy|help|abertura|salas|carteirinha|galeria|chat|projetos|calendario|tema|icones|filtros|fotos|novidades)\.spec\.mjs/ },
    { name: 'iphone', use: { ...devices['iPhone 14'] }, testMatch: /site\.spec\.mjs/ },
    { name: 'banco-e-codigo', testMatch: /(security|isolation|units)\.spec\.mjs/ },
  ],
});
