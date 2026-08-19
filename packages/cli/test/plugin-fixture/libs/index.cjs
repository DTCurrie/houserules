module.exports = function libsPlugin(api) {
  return [
    {
      id: 'libs',
      title: 'Libs',
      group: 'optional',
      hint: () => 'fixture module exercising derived lib actions',
      defaultEnabled: () => true,
      plan: () => [
        api.payload.script('libs', 'consumer.mjs', 'fixture consumer script'),
        api.payload.script('libs', 'consumer2.mjs', 'fixture consumer2 script'),
        api.payload.script(
          'libs',
          'lonely.mjs',
          'fixture script with no sidecar entry',
        ),
      ],
    },
  ];
};
