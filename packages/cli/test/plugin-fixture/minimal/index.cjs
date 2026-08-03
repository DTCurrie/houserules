module.exports = function minimalPlugin() {
  return [
    {
      id: 'minimal',
      title: 'Minimal',
      group: 'optional',
      hint: () => 'minimal fixture module',
      defaultEnabled: () => true,
      plan: () => [],
    },
  ];
};
