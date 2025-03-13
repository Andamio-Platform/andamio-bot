import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import axios from 'axios';

// Define the response structure from the API
interface SLT {
  id: string;
  moduleIndex: number;
  moduleId: string;
  sltText: string;
  createdById: string;
}

interface Lesson {
  id: string;
  title: string;
  live: boolean;
  sltId: string;
}

interface ModuleResponse {
  message: string;
  coursecode: string;
  modulecode: string;
  module: string;
  slts: SLT[];
  lessons: Lesson[];
}

// Define a custom interface for axios errors
interface AxiosError {
  response?: {
    status: number;
    statusText: string;
  };
  message: string;
}

export const data = new SlashCommandBuilder()
  .setName('module')
  .setDescription('Get information about an Andamio course module')
  .addStringOption(option => 
    option.setName('coursenftpolicyid')
      .setDescription('The Course NFT Policy Id to look up')
      .setRequired(true))
  .addStringOption(option => 
    option.setName('modulecode')
      .setDescription('The module code to look up')
      .setRequired(true));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  
  try {
    // Get the course NFT policy ID and module code from the command options
    const courseNftPolicyId = interaction.options.getString('coursenftpolicyid', true);
    const moduleCode = interaction.options.getString('modulecode', true);
    
    // Make the API request
    const response = await axios.get<ModuleResponse>(`https://preprod.andamio.io/api/course/nft/${courseNftPolicyId}/${moduleCode}`);
    const moduleData = response.data;
    
    // Create an embed with the module information
    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle(`Module: ${moduleData.module}`)
      .setDescription(`Part of course: ${moduleData.coursecode}`)
      .addFields(
        { name: 'Course NFT Policy Id', value: courseNftPolicyId, inline: true },
        { name: 'Module Code', value: moduleData.modulecode, inline: true },
        { name: 'Status', value: moduleData.message, inline: true },
        { name: 'Number of SLTs', value: moduleData.slts.length.toString(), inline: true },
        { name: 'Number of Lessons', value: moduleData.lessons.length.toString(), inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'Andamio Bot' });
    
    // Add SLTs to the embed (up to 5 to avoid hitting Discord's embed limits)
    if (moduleData.slts.length > 0) {
      const sltsField = moduleData.slts
        .sort((a, b) => a.moduleIndex - b.moduleIndex)
        .slice(0, 5)
        .map((slt, index) => `${index + 1}. ${slt.sltText}`)
        .join('\n');
      
      embed.addFields({ name: 'Student Learning Targets', value: sltsField });
      
      if (moduleData.slts.length > 5) {
        embed.addFields({ name: 'Note', value: `${moduleData.slts.length - 5} more SLTs not shown` });
      }
    }
    
    // Add lessons to the embed (up to 5)
    if (moduleData.lessons.length > 0) {
      const lessonsField = moduleData.lessons
        .slice(0, 5)
        .map((lesson, index) => `${index + 1}. ${lesson.title} ${lesson.live ? '✅' : '❌'}`)
        .join('\n');
      
      embed.addFields({ name: 'Lessons', value: lessonsField });
      
      if (moduleData.lessons.length > 5) {
        embed.addFields({ name: 'Note', value: `${moduleData.lessons.length - 5} more lessons not shown` });
      }
    }
    
    await interaction.editReply({ embeds: [embed] });
  } catch (error: unknown) {
    console.error('Error fetching module information:', error);
    
    // Check if it's an axios error by checking for the response property
    if (error && typeof error === 'object' && 'response' in error) {
      const axiosError = error as AxiosError;
      
      // Handle 404 errors specifically
      if (axiosError.response && axiosError.response.status === 404) {
        await interaction.editReply('Module not found. Please check the Course NFT Policy Id and module code and try again.');
      } else {
        // Handle other axios errors
        const status = axiosError.response ? axiosError.response.status : 'Unknown';
        const statusText = axiosError.response ? axiosError.response.statusText : 'Unknown Error';
        await interaction.editReply(`Error: ${status} - ${statusText}`);
      }
    } else {
      // Handle non-axios errors
      await interaction.editReply('An error occurred while fetching the module information. Please try again later.');
    }
  }
}