import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ComponentType, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, ModalSubmitInteraction } from 'discord.js';
import axios from 'axios';

// Define the response structure from the API
interface CourseResponse {
  message: string;
  count: number;
  courses: {
    title: string;
    courseNftPolicyId: string;
    courseCode: string;
    description: string;
    imageUrl: string;
    videoUrl: string;
  }[];
}

// Define the lesson response structure
interface LessonResponse {
  message: string;
  coursecode: string;
  modulecode: string;
  moduleindex: string;
  title: string;
  imageUrl: string | null;
  videoUrl: string;
  contentPreviewString: string;
  linkUrl: string;
}

// Define a custom interface for axios errors
interface AxiosError {
  response?: {
    status: number;
    statusText: string;
    data?: unknown;
  };
  message: string;
}

export const data = new SlashCommandBuilder()
  .setName('courses')
  .setDescription('Get a list of available Andamio courses');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  
  try {
    // Make the API request to get all courses
    const response = await axios.get<CourseResponse>('https://preprod.andamio.io/api/course/nfts');
    const coursesData = response.data;
    
    if (coursesData.count === 0) {
      await interaction.editReply('No courses are currently available.');
      return;
    }

    // Create a select menu with course options
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('course-select')
      .setPlaceholder('Select a course to view details')
      .addOptions(
        coursesData.courses.map(course => 
          new StringSelectMenuOptionBuilder()
            .setLabel(course.title)
            .setDescription(course.description.substring(0, 100) || 'No description available')
            .setValue(course.courseCode)
        )
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>()
      .addComponents(selectMenu);

    // Create an initial embed with course list
    const embed = new EmbedBuilder()
      .setColor('#0099ff')
      .setTitle('Available Andamio Courses')
      .setDescription(`Found ${coursesData.count} available courses. Select a course to view more details.`)
      .setTimestamp()
      .setFooter({ text: 'Andamio Bot' });

    const response2 = await interaction.editReply({
      embeds: [embed],
      components: [row]
    });

    // Create a collector for the select menu interaction
    const collector = response2.createMessageComponentCollector({ 
      componentType: ComponentType.StringSelect, 
      time: 60000 
    });

    // Flag to track if the user has successfully interacted with the command
    let hasUserInteracted = false;

    // Store the user ID and course NFT policy ID for modal handling
    const userData = {
      userId: interaction.user.id,
      courseNftPolicyIds: new Map<string, string>()
    };

    // Set up a listener for modal submissions that will handle all modals from this command
    const modalHandler = async (modalInteraction: ModalSubmitInteraction) => {
      // Check if this is our modal and from the same user
      if (!modalInteraction.customId.startsWith('lesson-modal-') || 
          modalInteraction.user.id !== userData.userId) return;
      
      try {
        const courseNftPolicyId = modalInteraction.customId.replace('lesson-modal-', '');
        const moduleCode = modalInteraction.fields.getTextInputValue('moduleCode');
        const moduleIndex = modalInteraction.fields.getTextInputValue('moduleIndex');

        console.log(`Fetching lesson: courseNftPolicyId=${courseNftPolicyId}, moduleCode=${moduleCode}, moduleIndex=${moduleIndex}`);
        
        // Try both API endpoints
        let lessonData: LessonResponse;
        let lessonResponse;
        
        try {
          // First try with /course/ endpoint
          lessonResponse = await axios.get<LessonResponse>(
            `https://preprod.andamio.io/api/course/${courseNftPolicyId}/${moduleCode}/${moduleIndex}`
          );
          lessonData = lessonResponse.data;
        } catch (courseError) {
          console.log('Error with /course/ endpoint, trying /course/nft/ endpoint');
          // If that fails, try with /course/nft/ endpoint
          lessonResponse = await axios.get<LessonResponse>(
            `https://preprod.andamio.io/api/course/nft/${courseNftPolicyId}/${moduleCode}/${moduleIndex}`
          );
          lessonData = lessonResponse.data;
        }

        // Create an embed with the lesson information
        const lessonEmbed = new EmbedBuilder()
          .setColor('#0099ff')
          .setTitle(`Lesson: ${lessonData.title || 'Untitled Lesson'}`);
        
        // Only set description if contentPreviewString exists
        if (lessonData.contentPreviewString) {
          lessonEmbed.setDescription(lessonData.contentPreviewString);
        }

        // Add fields with null/undefined checks
        lessonEmbed.addFields(
          { name: 'Course Code', value: lessonData.coursecode || 'N/A', inline: true },
          { name: 'Course NFT Policy Id', value: courseNftPolicyId || 'N/A', inline: true },
          { name: 'Module Code', value: lessonData.modulecode || 'N/A', inline: true },
          { name: 'Lesson Number', value: lessonData.moduleindex || 'N/A', inline: true },
          { name: 'Status', value: lessonData.message || 'N/A', inline: true }
        )
        .setTimestamp()
        .setFooter({ text: 'Andamio Bot' });

        // Add video URL if available
        if (lessonData.videoUrl && lessonData.videoUrl.trim() !== '') {
          lessonEmbed.addFields({ name: 'Video', value: lessonData.videoUrl });
        }

        // Set the image URL (use the lesson's image if available, otherwise use a default)
        const imageUrl = lessonData.imageUrl || 'https://app.andamio.io/images/sample-covers/1.jpg';
        lessonEmbed.setImage(imageUrl);

        // Add link to the lesson if available
        if (lessonData.linkUrl) {
          lessonEmbed.addFields({ name: 'View Lesson', value: `[Click here to view the full lesson](${lessonData.linkUrl})` });
        }

        // Create a back button
        const backButton = new ButtonBuilder()
          .setCustomId('back-to-courses')
          .setLabel('Back to Courses')
          .setStyle(ButtonStyle.Secondary);

        const buttonRow = new ActionRowBuilder<ButtonBuilder>()
          .addComponents(backButton);

        await modalInteraction.reply({ 
          embeds: [lessonEmbed],
          components: [buttonRow]
        });
      } catch (error: unknown) {
        console.error('Error handling modal or fetching lesson:', error);
        
        let errorMessage = 'An error occurred while fetching the lesson information. Please try again later.';
        
        if (error && typeof error === 'object' && 'response' in error) {
          const axiosError = error as AxiosError;
          
          console.error('API Error Details:', {
            status: axiosError.response?.status,
            statusText: axiosError.response?.statusText,
            data: axiosError.response?.data,
            message: axiosError.message
          });
          
          if (axiosError.response && axiosError.response.status === 404) {
            errorMessage = 'Lesson not found. Please check the module code and lesson number and try again.';
          } else {
            const status = axiosError.response ? axiosError.response.status : 'Unknown';
            const statusText = axiosError.response ? axiosError.response.statusText : 'Unknown Error';
            errorMessage = `Error: ${status} - ${statusText}`;
          }
        }
        
        try {
          await modalInteraction.reply({ 
            content: errorMessage,
            ephemeral: true
          });
        } catch (replyError) {
          console.error('Error replying to modal interaction:', replyError);
        }
      }
    };

    // Register the modal handler
    interaction.client.on('interactionCreate', async (interaction) => {
      if (interaction.isModalSubmit()) {
        await modalHandler(interaction as ModalSubmitInteraction);
      }
    });

    collector.on('collect', async i => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: 'This menu is not for you!', ephemeral: true });
        return;
      }

      // Mark that the user has successfully interacted
      hasUserInteracted = true;

      const selectedCourseCode = i.values[0];
      const selectedCourse = coursesData.courses.find(course => course.courseCode === selectedCourseCode);

      if (!selectedCourse) {
        await i.update({ content: 'Course not found. Please try again.', components: [] });
        return;
      }

      // Store the course NFT policy ID for later use
      userData.courseNftPolicyIds.set(selectedCourse.courseCode, selectedCourse.courseNftPolicyId);

      // Create a detailed embed for the selected course
      const detailedEmbed = new EmbedBuilder()
        .setColor('#0099ff')
        .setTitle(`Course: ${selectedCourse.title}`)
        .addFields(
          { name: 'Course Code', value: selectedCourse.courseCode, inline: true },
          { name: 'NFT Policy ID', value: selectedCourse.courseNftPolicyId, inline: true },
          { name: 'Description', value: selectedCourse.description || 'No description available' }
        )
        .setTimestamp()
        .setFooter({ text: 'Andamio Bot' });

      // Add image if available
      if (selectedCourse.imageUrl) {
        detailedEmbed.setImage(selectedCourse.imageUrl);
      }

      // Create buttons for viewing a lesson
      const viewLessonButton = new ButtonBuilder()
        .setCustomId(`view-lesson-${selectedCourse.courseNftPolicyId}`)
        .setLabel('View a Lesson')
        .setStyle(ButtonStyle.Primary);

      const backButton = new ButtonBuilder()
        .setCustomId('back-to-courses')
        .setLabel('Back to Courses')
        .setStyle(ButtonStyle.Secondary);

      const buttonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(viewLessonButton, backButton);

      await i.update({ 
        embeds: [detailedEmbed], 
        components: [buttonRow] 
      });
    });

    // Create a collector for button interactions
    const buttonCollector = response2.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 300000 // 5 minutes
    });

    buttonCollector.on('collect', async i => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: 'These buttons are not for you!', ephemeral: true });
        return;
      }

      if (i.customId === 'back-to-courses') {
        // Go back to the course selection menu
        await i.update({
          embeds: [embed],
          components: [row]
        });
        return;
      }

      if (i.customId.startsWith('view-lesson-')) {
        const courseNftPolicyId = i.customId.replace('view-lesson-', '');
        
        // Create a modal for the user to input module code and module index
        const modal = new ModalBuilder()
          .setCustomId(`lesson-modal-${courseNftPolicyId}`)
          .setTitle('View Lesson');

        // Add inputs for module code and module index
        const moduleCodeInput = new TextInputBuilder()
          .setCustomId('moduleCode')
          .setLabel('Module Code')
          .setPlaceholder('Enter the module code (e.g., M1)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const moduleIndexInput = new TextInputBuilder()
          .setCustomId('moduleIndex')
          .setLabel('Module Index (Lesson Number)')
          .setPlaceholder('Enter the lesson number (e.g., 1)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const moduleCodeRow = new ActionRowBuilder<TextInputBuilder>().addComponents(moduleCodeInput);
        const moduleIndexRow = new ActionRowBuilder<TextInputBuilder>().addComponents(moduleIndexInput);

        modal.addComponents(moduleCodeRow, moduleIndexRow);

        try {
          await i.showModal(modal);
        } catch (error) {
          console.error('Error showing modal:', error);
          await i.reply({ 
            content: 'An error occurred while trying to show the lesson form. Please try again later.',
            ephemeral: true
          });
        }
      }
    });

    collector.on('end', async (collected) => {
      // Only show timeout message if the user hasn't interacted
      if (!hasUserInteracted && collected.size === 0) {
        // Check if the message still exists and is editable
        try {
          await interaction.editReply({ 
            content: 'Course selection timed out. Use the /courses command again to view available courses.', 
            components: [] 
          });
        } catch (error) {
          console.error('Error updating message after timeout:', error);
        }
      }
      
      // Remove the event listener when done
      interaction.client.removeAllListeners('interactionCreate');
    });
  } catch (error: unknown) {
    console.error('Error fetching courses information:', error);
    
    // Check if it's an axios error by checking for the response property
    if (error && typeof error === 'object' && 'response' in error) {
      const axiosError = error as AxiosError;
      
      // Handle specific error codes
      if (axiosError.response) {
        await interaction.editReply(`Error: ${axiosError.response.status} - ${axiosError.response.statusText}`);
      } else {
        await interaction.editReply(`Error: ${axiosError.message}`);
      }
    } else {
      // Handle non-axios errors
      await interaction.editReply('An error occurred while fetching the courses information. Please try again later.');
    }
  }
}