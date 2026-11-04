const expoTransformer = require('@expo/metro-config/babel-transformer');

module.exports = {
  ...expoTransformer,
  transform(input) {
    // Expo preserves the parent NODE_ENV/BABEL_ENV even for --dev false.
    // Worklets reads those variables and otherwise emits Error stacks in a
    // Release bundle. Use the same mode as Metro's transform/cache request.
    const previousNodeEnv = process.env.NODE_ENV;
    const previousBabelEnv = process.env.BABEL_ENV;
    const mode = input.options.dev ? 'development' : 'production';
    process.env.NODE_ENV = mode;
    process.env.BABEL_ENV = mode;
    try {
      return expoTransformer.transform(input);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousBabelEnv === undefined) delete process.env.BABEL_ENV;
      else process.env.BABEL_ENV = previousBabelEnv;
    }
  },
};
