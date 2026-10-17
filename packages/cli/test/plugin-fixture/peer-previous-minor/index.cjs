module.exports = function peerPreviousMinorPlugin() {
  return [
    {
      id: 'previous-minor',
      title: 'Previous minor',
      group: 'optional',
      hint: () => 'peer-previous-minor fixture module',
      defaultEnabled: () => true,
      plan: () => [],
    },
  ];
};
