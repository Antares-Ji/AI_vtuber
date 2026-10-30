'use strict';
// A trusted, explicit provider example. No dynamic path comes from a model.
module.exports = {
  register(registry) {
    registry.register({ id: 'example:receipt-review', version: '1', game: 'shared', mode: 'read',
      description: 'Explain receipt versus observed completion.', resources: [],
      validate(args) {
        if (!args || Object.keys(args).some(key => key !== 'receipt') || typeof args.receipt !== 'string') throw Error('receipt string required');
        return { receipt: args.receipt.slice(0, 2000) };
      },
      async execute(args) { return { receipt: args.receipt, verified: false, next: 'Inspect fresh game evidence before accepting the goal.' }; }
    });
  }
};
