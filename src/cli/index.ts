#!/usr/bin/env bun
import { Command } from "commander";
import { getPackageVersion } from "../lib/version.js";

const program = new Command();
program
  .name("dispatch")
  .description("Dispatch prompts to coding agents in tmux windows")
  .version(getPackageVersion());

program.parseAsync(process.argv);
