// Mirrors a published plugin: the exports map declares "." and nothing else, so Node refuses
// to resolve this package's own package.json through a bare specifier.
module.exports = function gatedPlugin() {
  return [
    {
      id: 'gated',
      title: 'Gated',
      group: 'optional',
      hint: () => 'exports-gated fixture module',
      defaultEnabled: () => true,
      plan: () => [],
    },
  ];
};
