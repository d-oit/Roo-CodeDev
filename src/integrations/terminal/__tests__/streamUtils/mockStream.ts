// streamUtils/mockStream.ts
import { CommandStream } from "./index"

/**
 * Base function to create a mock stream with predefined output for testing without executing real commands
 * @param output The output to return in the stream
 * @param exitCode The exit code to return
 * @returns An object containing the stream and exit code
 */
export function createBaseMockStream(output: string, exitCode: number = 0): CommandStream {
	const bellChar = String.fromCharCode(7)
	const stream = {
		async *[Symbol.asyncIterator]() {
			// Start marker with BEL character to simulate real terminal behavior
			// Start marker with BEL character to simulate real terminal behavior
			yield `]633;C${bellChar}`

			// Yield the output - normalize line endings but preserve empty lines
			if (output.length > 0) {
				// Keep the content exactly as expected by the test
				const normalizedOutput = output.replace(/\r\n/g, "\n")
				if (normalizedOutput === "\n") {
					yield "\n" // Special case for single newline
				} else {
					// Don't strip any newlines here - let TerminalProcess handle that
					yield normalizedOutput
				}
			}

			// End marker with BEL character
			yield `]633;D${bellChar}`
		},
	}

	return { stream, exitCode }
}

/**
 * Creates a mock stream for Bash output
 * @param output The output to return in the stream
 * @param exitCode The exit code to return
 * @returns An object containing the stream and exit code
 */
export function createBashMockStream(output: string, exitCode: number = 0): CommandStream {
	// For bash, we ensure Unix-style line endings
	const unixOutput = output.replace(/\r\n/g, "\n")
	return createBaseMockStream(unixOutput, exitCode)
}

/**
 * Creates a mock stream for CMD output
 * @param output The output to return in the stream
 * @param exitCode The exit code to return
 * @returns An object containing the stream and exit code
 */
export function createCmdMockStream(output: string, exitCode: number = 0): CommandStream {
	// For CMD, we ensure Windows-style line endings
	const windowsOutput = output.replace(/\n/g, "\r\n").replace(/\r\r\n/g, "\r\n")
	return createBaseMockStream(windowsOutput, exitCode)
}

/**
 * Creates a mock stream for PowerShell output
 * @param output The output to return in the stream
 * @param exitCode The exit code to return
 * @returns An object containing the stream and exit code
 */
export function createPowerShellMockStream(output: string, exitCode: number = 0): CommandStream {
	// For PowerShell, we normalize to Unix-style line endings as the real implementation does
	const normalizedOutput = output.replace(/\r\n/g, "\n")
	return createBaseMockStream(normalizedOutput, exitCode)
}

/**
 * Creates a mock stream that yields output in chunks to simulate real terminal behavior
 * @param output The output to return in chunks
 * @param chunkSize The approximate size of each chunk
 * @param exitCode The exit code to return
 * @returns An object containing the stream and exit code
 */
export function createChunkedMockStream(output: string, chunkSize: number = 100, exitCode: number = 0): CommandStream {
	const bellChar = String.fromCharCode(7)
	const stream = {
		async *[Symbol.asyncIterator]() {
			// Start marker with BEL character
			yield `]633;C${bellChar}`

			// Yield the output in chunks
			if (output.length > 0) {
				// Normalize line endings first
				const normalizedOutput = output.replace(/\r\n/g, "\n")

				// Split output into chunks of approximately chunkSize
				// Not splitting exactly on chunkSize to simulate real-world behavior
				// where data might be split in the middle of lines
				let remaining = normalizedOutput
				while (remaining.length > 0) {
					// Vary chunk size slightly to simulate real terminal behavior
					const actualChunkSize = Math.min(remaining.length, chunkSize + Math.floor(Math.random() * 20) - 10)

					const chunk = remaining.substring(0, actualChunkSize)
					remaining = remaining.substring(actualChunkSize)

					// Add small delay to simulate network/processing delay
					await new Promise((resolve) => setTimeout(resolve, 1))

					yield chunk
				}
			}

			// End marker with BEL character
			yield `]633;D${bellChar}`
		},
	}

	return { stream, exitCode }
}
