const path = require('path');
const TerserPlugin = require('terser-webpack-plugin');

module.exports = {
  entry: './src/highlight-tracker.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'highlight-tracker.min.js',
    library: 'HighlightTracker',
    libraryTarget: 'umd',
    libraryExport: 'default',
    globalObject: 'this'
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: ['@babel/preset-env']
          }
        }
      }
    ]
  },
  optimization: {
    minimize: true,
    minimizer: [new TerserPlugin()]
  }
};