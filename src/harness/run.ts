/**
 * The local harness. It plays recorded audio at the service and DIALS NOBODY.
 *
 * This is the whole test story for TASK-970: no phone carrier, no cloud deploy, no live booking and
 * no customer data. A fixture is one recorded conversation; assert on the TRANSCRIPT it produces,
 * never on the audio, and assert that no sentence appears which the backend did not supply.
 *
 * TASK-970 implements this. The five fixtures it must cover are listed in test/fixtures/README.md.
 */

export async function main(): Promise<void> {
    console.log('venue-call-agent harness — dials nobody.');
    console.log('Not implemented yet. TASK-970 builds it; test/fixtures/README.md lists the five');
    console.log('conversations it has to cover. Run `npm test` for the guards that already exist.');
}

await main();
