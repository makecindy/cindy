// The upgrade coordinator consumes the same declaration as the Host health
// endpoint. Turn this on only after #9830 and client-handoff joint acceptance;
// a command-line flag or an isolated task test cannot grant feature parity.
export const clientMigrationContract = Object.freeze({ protocol: 1, ready: false });
