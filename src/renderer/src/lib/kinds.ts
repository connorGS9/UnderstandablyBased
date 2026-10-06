/** What to do first, per kind of program. Shown on the Overview and in the welcome tip. */
export const KIND_GUIDE: Record<string, string> = {
  'web-backend': 'Start from a route in Explore: each one shows the controller that handles it, the services it calls, and the tables it touches.',
  'fullstack-web': 'This repo has both a backend and a frontend. Routes show the server side; Pages show screens in the UI.',
  'web-frontend': 'Start from a page: it shows the components and data-fetching code behind each screen.',
  'low-latency': 'Start from a process (main) or a channel. Channels show which processes write to and read from each shared-memory segment, socket or topic.',
  game: 'Start from main or the game loop; look for update/render functions and the systems they call.',
  cli: 'Start from main; commands usually branch out from argument parsing there.',
  library: 'No entry points were found, so this looks like a library. Use search (Ctrl+K) to jump to its public classes and functions.',
  generic: 'Start from a main() function in Processes and follow what it calls.',
};
