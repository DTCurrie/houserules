module.exports = function requiresUnmetPlugin() {
  return [
    {
      id: 'needy',
      title: 'Needy',
      group: 'optional',
      hint: () => 'requires a module nothing supplies',
      defaultEnabled: () => false,
      requires: [{ id: 'ghost-module', package: '@acme/ghost' }],
      plan: () => [],
    },
    {
      id: 'choosy',
      title: 'Choosy',
      group: 'optional',
      hint: () => 'an option value requires sweep',
      defaultEnabled: () => false,
      options: {
        prompt: 'Which extras?',
        choices: [
          { value: 'plain', label: 'Plain' },
          { value: 'extra', label: 'Extra', requires: [{ id: 'sweep' }] },
        ],
        defaults: ['plain'],
      },
      plan: () => [],
    },
  ];
};
