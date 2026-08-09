module.exports = function badLibPlugin(api) {
  return [
    {
      id: 'bad-lib',
      title: 'Bad Lib',
      group: 'optional',
      hint: () =>
        'fixture module whose sidecar names a lib the CLI does not ship',
      defaultEnabled: () => true,
      plan: () => [
        api.payload.script(
          'bad-lib',
          'consumer.mjs',
          'fixture consumer script',
        ),
      ],
    },
  ];
};
