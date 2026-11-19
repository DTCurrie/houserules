module.exports = function optionRetentionPlugin() {
  return [
    {
      id: 'needy',
      title: 'Needy',
      group: 'optional',
      hint: () => 'requires choosy',
      defaultEnabled: () => false,
      requires: [{ id: 'choosy' }],
      plan: () => [],
    },
    {
      id: 'choosy',
      title: 'Choosy',
      group: 'optional',
      hint: () => 'carries an option with a default',
      defaultEnabled: () => false,
      options: {
        prompt: 'Which flavor?',
        choices: [
          { value: 'plain', label: 'Plain' },
          { value: 'spicy', label: 'Spicy' },
        ],
        defaults: ['plain'],
      },
      plan: () => [],
    },
  ];
};
