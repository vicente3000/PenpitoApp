module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test', '<rootDir>/src'],
  testMatch: ['**/?(*.)+(test|spec).ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  transformIgnorePatterns: ['/node_modules/'],
};
